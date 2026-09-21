import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  GAMIFICATION_COPY,
  type GamificationSnapshot,
} from '../../shared/gamification-types';
import {
  activeOperatorQuests,
  listAchievementProgress,
  tierProgress,
  xpKindLabel,
} from '../../shared/gamification-progress';
import { useGamificationStore } from '../state/gamification-store';
import { useQuotaStore } from '../state/quota-store';
import { useLifetimeUsage } from '../state/lifetime-usage';
import { ChosenPetPortrait } from './ChosenPetPortrait';
import { fmt } from './operator-sprite-data';
import { fmtTokens, fmtUsd } from '../lib/lifetime-format';
import { formatShortcut } from '../lib/platform';
import { PixelIcon } from './PixelIcon';

/**
 * Perfil de Operador — cockpit gamificado vivo:
 * poder + próximo marco, quests acionáveis, feed de XP, conquistas com
 * progresso (não só "Bloqueada"), skins e I/O. Abre com hydrate fresco.
 */

const XP_BREAKDOWN_COPY: Array<[string, string]> = [
  ['mission_green', 'missões verdes (verificadas)'],
  ['mission_done', 'missões concluídas'],
  ['handoff_green', 'entregas verificadas'],
  ['handoff_success', 'resultados entregues'],
  ['task_done', 'tasks concluídas'],
  ['agent_turn', 'turnos de agente entregues'],
  ['media_generated', 'mídias geradas'],
  ['jarvis_action', 'ações da Jarvis no IDE'],
];

const DEFAULT_SKIN_LABEL = 'padrão';

function receive(snapshot: GamificationSnapshot): void {
  useGamificationStore.getState().receive(snapshot);
}

function formatRelativeTime(createdAt: number, now: number): string {
  const deltaSec = Math.max(0, Math.round((now - createdAt) / 1000));
  if (deltaSec < 60) return 'agora';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} min`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)} h`;
  return `${Math.floor(deltaSec / 86_400)} d`;
}

export function OperatorProfile() {
  const open = useGamificationStore((s) => s.profileOpen);
  const close = useGamificationStore((s) => s.closeProfile);
  const snapshot = useGamificationStore((s) => s.snapshot);
  const sober = useGamificationStore((s) => s.sober);
  const setSober = useGamificationStore((s) => s.setSober);
  const [confirmPrestige, setConfirmPrestige] = useState(false);
  const [ioMessage, setIoMessage] = useState<string | null>(null);
  const lifetime = useLifetimeUsage(open);
  // Assinaturas conectadas: soma dos planos detectados pelos próprios
  // providers (sai do somatório quando a conta é removida).
  const plans = useQuotaStore((s) => s.snapshot.plans);
  const [now, setNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
      return;
    }

    if (
      restoreFocusRef.current === null &&
      document.activeElement instanceof HTMLElement &&
      !dialogRef.current?.contains(document.activeElement)
    ) {
      restoreFocusRef.current = document.activeElement;
    }

    const initialFocus = dialogRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    initialFocus?.focus();
  }, [open]);

  useEffect(
    () => () => {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      setConfirmPrestige(false);
      setIoMessage(null);
      return undefined;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [open]);



  const progress = useMemo(() => tierProgress(snapshot), [snapshot]);
  const quests = useMemo(() => activeOperatorQuests(snapshot), [snapshot]);
  const achievements = useMemo(
    () => listAchievementProgress(snapshot),
    [snapshot],
  );
  const unlockedCount = achievements.filter((item) => item.unlocked).length;
  const emptyProfile =
    snapshot.powerLevel === 0 &&
    Object.values(snapshot.counters).every((value) => value === 0) &&
    Object.values(lifetime?.counters ?? {}).every((value) => value === 0);
  const stars = '★'.repeat(Math.min(snapshot.prestige, 5));
  const efficient = snapshot.counters.efficient_mission ?? 0;
  const recent = snapshot.recent ?? [];

  if (!open) return null;

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
        ref={dialogRef}
        className="operator-profile"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          if (event.key !== 'Tab') return;

          event.preventDefault();
          event.stopPropagation();
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ),
          ).filter(
            (element) => element.getAttribute('aria-hidden') !== 'true',
          );
          if (controls.length === 0) {
            event.currentTarget.focus();
            return;
          }
          const currentIndex = controls.indexOf(
            document.activeElement as HTMLElement,
          );
          const nextIndex = event.shiftKey
            ? currentIndex <= 0
              ? controls.length - 1
              : currentIndex - 1
            : (currentIndex + 1) % controls.length;
          controls[nextIndex]?.focus();
        }}
      >
        <header className="operator-profile__header">
          <ChosenPetPortrait
            size={96}
            mood="idle"
            fallbackTier={snapshot.tier}
            fallbackBranch={snapshot.branch}
            fallbackSkin={snapshot.selectedSkin}
            className="operator-profile__pet"
          />
          <div className="operator-profile__identity">
            <h2 id={titleId} className="operator-profile__title">
              Perfil de Operador
            </h2>
            <span className="operator-profile__branch">
              {GAMIFICATION_COPY.branches[snapshot.branch]}
              {stars && (
                <span
                  className="operator-profile__stars"
                  title={`Transcendência ${snapshot.prestige}`}
                >
                  {stars}
                </span>
              )}
            </span>
            <span className="operator-profile__tier">
              {GAMIFICATION_COPY.tiers[snapshot.tier]}
            </span>
            <span className="operator-profile__power-label">Poder</span>
            <span
              className="operator-profile__power"
              title={`${snapshot.powerLevel.toLocaleString('pt-BR')} de poder`}
            >
              {fmt(snapshot.powerLevel)}
            </span>
            <span className="operator-profile__bar" aria-hidden="true">
              <span
                className="operator-profile__bar-fill"
                style={{ transform: `scaleX(${progress.ratio})` }}
              />
            </span>
            <span id={descriptionId} className="operator-profile__next">
              {progress.remaining === null
                ? snapshot.prestigeReady
                  ? 'jornada no topo — pronta para transcender'
                  : 'jornada no topo'
                : `faltam ${fmt(progress.remaining)} para o próximo marco (${fmt(snapshot.nextTierAt ?? 0)})`}
            </span>
          </div>
          <button
            type="button"
            className="operator-profile__close"
            onClick={close}
            aria-label="Fechar perfil"
          >
            <PixelIcon name="close" size={12} />
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

        {lifetime && (
          <section
            className="operator-profile__consumo"
            aria-label="Consumo real acumulado"
          >
            <div className="operator-profile__consumo-head">
              <h3>Consumo real</h3>
              <span className="operator-profile__consumo-note">
                todos os projetos · quanto custaria em API paga
              </span>
            </div>
            <div className="operator-profile__consumo-grid">
              <div className="operator-profile__consumo-cell operator-profile__consumo-cell--money">
                <span className="operator-profile__consumo-value">
                  {fmtUsd(lifetime.usdEquivalent)}
                </span>
                <span className="operator-profile__consumo-label">
                  economizados em assinatura
                </span>
              </div>
              <div className="operator-profile__consumo-cell">
                <span className="operator-profile__consumo-value">
                  {fmtTokens(lifetime.tokensBurned)}
                </span>
                <span className="operator-profile__consumo-label">
                  tokens torrados
                </span>
              </div>
              <div className="operator-profile__consumo-cell">
                <span className="operator-profile__consumo-value">
                  {lifetime.panesServed}
                </span>
                <span className="operator-profile__consumo-label">panes</span>
              </div>
              <div className="operator-profile__consumo-cell">
                <span className="operator-profile__consumo-value">
                  {fmt(lifetime.turns)}
                </span>
                <span className="operator-profile__consumo-label">turnos</span>
              </div>
              {lifetime.mediaUsd > 0 && (
                <div className="operator-profile__consumo-cell">
                  <span className="operator-profile__consumo-value">
                    {fmtUsd(lifetime.mediaUsd)}
                  </span>
                  <span className="operator-profile__consumo-label">
                    em mídia gerada
                  </span>
                </div>
              )}
              {plans && plans.detected > 0 && (
                <div
                  className="operator-profile__consumo-cell"
                  title={
                    plans.undetected > 0
                      ? `${plans.detected} assinatura(s) detectada(s) · ${plans.undetected} elegível(eis) sem plano identificado não entram na soma`
                      : `${plans.detected} assinatura(s) detectada(s) pelos providers`
                  }
                >
                  <span className="operator-profile__consumo-value">
                    {fmtUsd(plans.monthlyUsd)}
                  </span>
                  <span className="operator-profile__consumo-label">
                    {plans.detected === 1
                      ? 'assinatura por mês'
                      : `${plans.detected} assinaturas por mês`}
                  </span>
                </div>
              )}
              <div className="operator-profile__consumo-cell">
                <span className="operator-profile__consumo-value">
                  {lifetime.missionsDone}
                </span>
                <span className="operator-profile__consumo-label">
                  missões vistas
                </span>
              </div>
            </div>
          </section>
        )}

        {emptyProfile ? (
          <div className="operator-profile__empty" role="status">
            <strong className="operator-profile__empty-title">
              Operador em modo recruta
            </strong>
            <p>
              O XP sobe com <em>entrega real</em> — turno de agente com saída,
              missão concluída, handoff verificado, task done, mídia gerada ou
              ação da Jarvis. O consumo acima já é seu: a assinatura cobre o
              que a API cobraria.
            </p>
          </div>
        ) : (
          <div className="operator-profile__pulse" role="status">
            <span>
              {unlockedCount}/{achievements.length} conquistas
            </span>
            <span aria-hidden="true">·</span>
            <span>{snapshot.streakDays} dias seguidos</span>
            <span aria-hidden="true">·</span>
            <span>{snapshot.shieldsLeft} escudos</span>
          </div>
        )}

        {quests.length > 0 && (
          <section
            className="operator-profile__section"
            aria-label="Próximas recompensas"
          >
            <h3>Próximas recompensas</h3>
            <ul className="operator-profile__quests">
              {quests.map((quest) => (
                <li key={quest.id} className="operator-profile__quest">
                  <div className="operator-profile__quest-head">
                    <strong>{quest.title}</strong>
                    <span className="operator-profile__quest-meta">
                      {quest.current}/{quest.target} · {quest.rewardHint}
                    </span>
                  </div>
                  <p className="operator-profile__quest-hint">{quest.hint}</p>
                  <span
                    className="operator-profile__mini-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={quest.target}
                    aria-valuenow={Math.min(quest.current, quest.target)}
                    aria-label={`${quest.title}: ${quest.current} de ${quest.target}`}
                  >
                    <span
                      className="operator-profile__mini-bar-fill"
                      style={{ transform: `scaleX(${quest.ratio})` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {recent.length > 0 && (
          <section className="operator-profile__section" aria-label="Feed de XP">
            <h3>Feed recente</h3>
            <ul className="operator-profile__feed">
              {recent.map((event, index) => (
                <li
                  key={`${event.createdAt}-${event.kind}-${index}`}
                  className="operator-profile__feed-item"
                >
                  <span className="operator-profile__feed-xp">
                    +{fmt(event.points)}
                  </span>
                  <span className="operator-profile__feed-kind">
                    {xpKindLabel(event.kind)}
                  </span>
                  <span className="operator-profile__feed-time">
                    {formatRelativeTime(event.createdAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="operator-profile__grid">
          <section
            className="operator-profile__section"
            aria-label="Detalhes dos pontos"
          >
            <h3>Entregas · todos os projetos</h3>
            <ul className="operator-profile__list">
              {XP_BREAKDOWN_COPY.map(([kind, label]) => (
                <li key={kind}>
                  <span
                    className="operator-profile__count"
                    title={
                      lifetime?.counters[kind] !== undefined &&
                      lifetime.counters[kind]! >
                        (snapshot.counters[kind] ?? 0)
                        ? `${lifetime.counters[kind]} em todos os projetos`
                        : undefined
                    }
                  >
                    {Math.max(
                      snapshot.counters[kind] ?? 0,
                      lifetime?.counters[kind] ?? 0,
                    )}
                  </span>{' '}
                  {label}
                </li>
              ))}
            </ul>
          </section>

          <section
            className="operator-profile__section"
            aria-label="Ritmo e eficiência"
          >
            <h3>Ritmo</h3>
            <ul className="operator-profile__list">
              <li>
                <span className="operator-profile__count">
                  {snapshot.streakDays}
                </span>{' '}
                dias úteis seguidos
              </li>
              <li>
                <span className="operator-profile__count">
                  {snapshot.shieldsLeft}
                </span>{' '}
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
            {achievements.map((item) => (
              <div
                key={item.id}
                className={
                  item.unlocked
                    ? 'operator-profile__achievement operator-profile__achievement--live'
                    : 'operator-profile__achievement operator-profile__achievement--locked'
                }
              >
                <span className="operator-profile__achievement-title">
                  {item.title}
                </span>
                <span className="operator-profile__achievement-desc">
                  {item.unlocked
                    ? item.description
                    : `${item.current}/${item.target} · ${item.description}`}
                </span>
                <span
                  className="operator-profile__mini-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={item.target}
                  aria-valuenow={Math.min(item.current, item.target)}
                  aria-label={`${item.title}: ${item.current} de ${item.target}`}
                >
                  <span
                    className="operator-profile__mini-bar-fill"
                    style={{ transform: `scaleX(${item.ratio})` }}
                  />
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="operator-profile__section" aria-label="Skins">
          <h3>Visuais do mascote</h3>
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
            {snapshot.skins.length === 0 && (
              <span className="operator-profile__hint-inline">
                Desbloqueie novos visuais ao completar conquistas.
              </span>
            )}
          </div>
        </section>

        <footer className="operator-profile__footer">
          <button
            type="button"
            className="operator-profile__btn"
            onClick={() => void handleExport()}
          >
            Exportar perfil
          </button>
          <button
            type="button"
            className="operator-profile__btn"
            onClick={() => void handleImport()}
          >
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
            Reabra este perfil a qualquer momento com{' '}
            {formatShortcut('mod', 'shift', 'O')}. O XP
            é contado por pasta de projeto.
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
