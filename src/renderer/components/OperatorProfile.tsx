import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  GAMIFICATION_COPY,
  type GamificationSnapshot,
} from '../../shared/gamification-types';
import {
  activeOperatorQuests,
  listAchievementProgress,
  nextTierOf,
  nextTierPlan,
  pluralPt,
  recentAchievements,
  tierProgress,
  withGlobalXp,
  xpKindLabel,
} from '../../shared/gamification-progress';
import { useGamificationStore } from '../state/gamification-store';
import { useQuotaStore } from '../state/quota-store';
import { useWorkspaceStore } from '../state/workspace-store';
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
 * A entrada visível mora no `OperatorHud` (rail e Minha conta), não só aqui.
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

/** O feed é um relance, não um histórico: sem rolagem aninhada dentro do diálogo. */
const FEED_LIMIT = 8;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

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
  const projectSnapshot = useGamificationStore((s) => s.snapshot);
  const snapshot = useMemo(() => withGlobalXp(projectSnapshot), [projectSnapshot]);
  const globalXp = projectSnapshot.global ?? null;
  const sober = useGamificationStore((s) => s.sober);
  const setSober = useGamificationStore((s) => s.setSober);
  const [confirmPrestige, setConfirmPrestige] = useState(false);
  const [ioMessage, setIoMessage] = useState<string | null>(null);
  const lifetime = useLifetimeUsage(open);
  // Assinaturas conectadas: soma dos planos detectados pelos próprios
  // providers (sai do somatório quando a conta é removida).
  const plans = useQuotaStore((s) => s.snapshot.plans);
  // O XP é por pasta de projeto: o nome do projeto ativo explica o número.
  const projectName = useWorkspaceStore((s) => s.current?.name ?? null);
  const [now, setNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const sectionId = useId();

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

    const initialFocus = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
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
  const stars = Math.min(Math.max(snapshot.prestige, 0), 5);
  const efficient = snapshot.counters.efficient_mission ?? 0;
  const recent = (snapshot.recent ?? []).slice(0, FEED_LIMIT);
  const todayXp = snapshot.todayXp ?? 0;
  const recentUnlocks = recentAchievements(snapshot.achievements);
  const plan = nextTierPlan(progress.remaining);
  const nextTier = nextTierOf(snapshot.tier);
  const nextTierName = nextTier ? GAMIFICATION_COPY.tiers[nextTier] : null;
  const nextLine =
    progress.remaining === null
      ? snapshot.prestigeReady
        ? 'Jornada no topo. Pronta para transcender.'
        : 'Jornada no topo.'
      : `Faltam ${fmt(progress.remaining)} XP para ${nextTierName ?? 'o próximo marco'}.`;
  const scopeLine = [
    snapshot.branch !== 'base'
      ? `Ramo ${GAMIFICATION_COPY.branches[snapshot.branch]}`
      : null,
    globalXp
      ? `XP de ${pluralPt(globalXp.projectCount, 'projeto', 'projetos')}`
      : projectName
        ? `XP do projeto ${projectName}`
        : null,
  ]
    .filter(Boolean)
    .join(' · ');

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

  const consumoId = `${sectionId}-consumo`;
  const questsId = `${sectionId}-quests`;
  const achievementsId = `${sectionId}-achievements`;
  const feedId = `${sectionId}-feed`;
  const deliveriesId = `${sectionId}-deliveries`;
  const skinsId = `${sectionId}-skins`;

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
            event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
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
            {scopeLine ? (
              <span className="operator-profile__scope">{scopeLine}</span>
            ) : null}
            <div className="operator-profile__rank">
              <span className="operator-profile__tier">
                {GAMIFICATION_COPY.tiers[snapshot.tier]}
              </span>
              {stars > 0 ? (
                <span
                  className="operator-profile__stars"
                  role="img"
                  aria-label={`Transcendência ${snapshot.prestige}`}
                  title={`Transcendência ${snapshot.prestige}`}
                >
                  {Array.from({ length: stars }, (_, index) => (
                    <PixelIcon key={index} name="star" size={11} />
                  ))}
                </span>
              ) : null}
            </div>
            <div className="operator-profile__power-row">
              <span
                className="operator-profile__power"
                title={`${snapshot.powerLevel.toLocaleString('pt-BR')} de poder`}
              >
                {fmt(snapshot.powerLevel)}
              </span>
              <span className="operator-profile__power-label">de poder</span>
            </div>
            <span className="operator-profile__bar" aria-hidden="true">
              <span
                className="operator-profile__bar-fill"
                style={{ transform: `scaleX(${progress.ratio})` }}
              />
            </span>
            <span id={descriptionId} className="operator-profile__next">
              {nextLine}
            </span>
            {plan && <span className="operator-profile__plan">{plan}</span>}
            <span
              className={
                todayXp > 0
                  ? 'operator-profile__today operator-profile__today--live'
                  : 'operator-profile__today'
              }
            >
              {todayXp > 0
                ? `+${fmt(todayXp)} XP hoje`
                : 'nenhuma entrega hoje ainda'}
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

        {globalXp && globalXp.projects.length > 0 ? (
          <section
            className="operator-profile__projects"
            aria-label="XP por projeto"
          >
            <h3 className="operator-profile__projects-title">Por projeto</h3>
            <ul className="operator-profile__projects-list">
              {globalXp.projects.map((item, index) => (
                <li
                  key={`${item.label}-${index}`}
                  className={
                    item.current
                      ? 'operator-profile__project operator-profile__project--current'
                      : 'operator-profile__project'
                  }
                >
                  <span className="operator-profile__project-name">
                    {item.label}
                    {item.current ? ' · aqui' : ''}
                  </span>
                  <strong
                    title={`${item.power.toLocaleString('pt-BR')} de poder`}
                  >
                    {fmt(item.power)}
                  </strong>
                </li>
              ))}
            </ul>
            <span className="operator-profile__projects-note">
              Soma dos projetos já abertos nesta versão; cada projeto entra ao ser
              aberto.
            </span>
          </section>
        ) : null}

        <ul className="operator-profile__stats" aria-label="Resumo da jornada">
          <li>
            <strong>
              {unlockedCount}/{achievements.length}
            </strong>{' '}
            conquistas
          </li>
          <li>
            <strong>{snapshot.streakDays}</strong>{' '}
            {snapshot.streakDays === 1
              ? 'dia útil seguido'
              : 'dias úteis seguidos'}
          </li>
          <li>
            <strong>{snapshot.shieldsLeft}</strong>{' '}
            {snapshot.shieldsLeft === 1 ? 'escudo' : 'escudos'} no mês
          </li>
        </ul>

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
                <PixelIcon name="star" size={11} />
                Transcender
              </button>
            )}
          </div>
        )}

        {emptyProfile && (
          <div className="operator-profile__empty" role="status">
            <strong className="operator-profile__empty-title">
              Operador em modo recruta
            </strong>
            <p>
              O XP sobe com <em>entrega real</em>: turno de agente com saída,
              handoff aceito pelo orquestrador, missão concluída, task done,
              mídia gerada ou ação da Jarvis. O consumo abaixo já é seu: a
              assinatura cobre o
              que a API cobraria.
            </p>
          </div>
        )}

        {lifetime && (
          <section
            className="operator-profile__section operator-profile__consumo"
            aria-labelledby={consumoId}
          >
            <div className="operator-profile__section-head">
              <h3 id={consumoId}>Consumo real</h3>
              <span className="operator-profile__section-note">
                todos os projetos · quanto custaria em API paga
              </span>
            </div>
            <div className="operator-profile__consumo-hero">
              <span className="operator-profile__consumo-money">
                {fmtUsd(lifetime.usdEquivalent)}
              </span>
              <span className="operator-profile__consumo-money-label">
                economizados em assinatura
              </span>
            </div>
            <dl className="operator-profile__facts">
              <div>
                <dt>tokens torrados</dt>
                <dd>{fmtTokens(lifetime.tokensBurned)}</dd>
              </div>
              <div>
                <dt>panes</dt>
                <dd>{lifetime.panesServed}</dd>
              </div>
              <div>
                <dt>turnos</dt>
                <dd>{fmt(lifetime.turns)}</dd>
              </div>
              <div>
                <dt>missões vistas</dt>
                <dd>{lifetime.missionsDone}</dd>
              </div>
              {lifetime.mediaUsd > 0 && (
                <div>
                  <dt>em mídia gerada</dt>
                  <dd>{fmtUsd(lifetime.mediaUsd)}</dd>
                </div>
              )}
            </dl>
            {plans && plans.detected > 0 && (
              <p
                className="operator-profile__plans-note"
                title={
                  plans.connected > plans.priced
                    ? `${fmtUsd(plans.monthlyUsd)} por mês soma só os ${plans.priced} planos com preço de lista. ${plans.connected - plans.priced} contas conectadas ficam de fora porque o provider não informou o plano ou o preço não é único.`
                    : `${plans.detected} assinatura(s) detectada(s) pelos providers`
                }
              >
                {plans.priced === 0
                  ? `${pluralPt(plans.detected, 'assinatura detectada', 'assinaturas detectadas')}, sem preço de lista para somar.`
                  : `Assinaturas: ${fmtUsd(plans.monthlyUsd)}/mês em ${pluralPt(plans.priced, 'plano com preço', 'planos com preço')}${
                      plans.connected > plans.priced
                        ? ` · ${pluralPt(plans.connected - plans.priced, 'conta fora', 'contas fora')} da soma`
                        : ''
                    }.`}
              </p>
            )}
          </section>
        )}

        {recentUnlocks.length > 0 && (
          <section
            className="operator-profile__section"
            aria-label="Conquistas recentes"
          >
            <h3>Desbloqueadas por último</h3>
            <ul className="operator-profile__recent-unlocks">
              {recentUnlocks.map((item) => (
                <li
                  key={item.id}
                  className="operator-profile__recent-unlock"
                  title={item.description}
                >
                  {item.title}
                </li>
              ))}
            </ul>
          </section>
        )}

        {quests.length > 0 && (
          <section
            className="operator-profile__section"
            aria-labelledby={questsId}
          >
            <h3 id={questsId}>Próximas recompensas</h3>
            <ul className="operator-profile__quests">
              {quests.map((quest) => (
                <li key={quest.id} className="operator-profile__quest">
                  <span
                    className="operator-profile__quest-mark"
                    aria-hidden="true"
                  />
                  <div className="operator-profile__quest-body">
                    <strong className="operator-profile__quest-title">
                      {quest.title}
                    </strong>
                    <p className="operator-profile__quest-hint">{quest.hint}</p>
                    {quest.target > 1 && (
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
                    )}
                  </div>
                  <div className="operator-profile__quest-reward">
                    <span className="operator-profile__quest-count">
                      {quest.current}/{quest.target}
                    </span>
                    <span className="operator-profile__quest-meta">
                      {quest.rewardHint}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section
          className="operator-profile__section"
          aria-labelledby={achievementsId}
        >
          <div className="operator-profile__section-head">
            <h3 id={achievementsId}>Conquistas</h3>
            <span className="operator-profile__section-note">
              {unlockedCount} de {achievements.length}
            </span>
          </div>
          <ul className="operator-profile__achievements">
            {achievements.map((item) => (
              <li
                key={item.id}
                className={
                  item.unlocked
                    ? 'operator-profile__achievement operator-profile__achievement--live'
                    : 'operator-profile__achievement operator-profile__achievement--locked'
                }
              >
                <span className="operator-profile__achievement-title">
                  {item.title}
                  {item.unlocked && (
                    <span className="operator-profile__achievement-badge">
                      <PixelIcon name="check" size={10} />
                      Conquistada
                    </span>
                  )}
                </span>
                <span className="operator-profile__achievement-desc">
                  {item.unlocked
                    ? item.description
                    : `${item.current}/${item.target} · ${item.description}`}
                </span>
                {!item.unlocked && item.target > 1 && (
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
                )}
              </li>
            ))}
          </ul>
        </section>

        <div
          className={
            recent.length > 0
              ? 'operator-profile__grid'
              : 'operator-profile__grid operator-profile__grid--single'
          }
        >
          {recent.length > 0 && (
            <section
              className="operator-profile__section"
              aria-labelledby={feedId}
            >
              <h3 id={feedId}>Feed recente</h3>
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
                      {(event.count ?? 1) > 1 ? ` ×${event.count}` : ''}
                    </span>
                    <span className="operator-profile__feed-time">
                      {formatRelativeTime(event.createdAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section
            className="operator-profile__section"
            aria-labelledby={deliveriesId}
          >
            <h3 id={deliveriesId}>Entregas · todos os projetos</h3>
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
              <li>
                <span className="operator-profile__count">{efficient}</span>{' '}
                missões na banda eficiente
              </li>
            </ul>
          </section>
        </div>

        <section
          className="operator-profile__section"
          aria-labelledby={skinsId}
        >
          <h3 id={skinsId}>Visuais do mascote</h3>
          <div className="operator-profile__skins">
            <button
              type="button"
              aria-pressed={snapshot.selectedSkin === null}
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
                aria-pressed={snapshot.selectedSkin === skin}
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
            Modo sóbrio (esconde pontos e celebrações; o XP continua)
          </label>
          <span className="operator-profile__hint">
            Reabra este perfil pelo cartão no menu lateral ou com{' '}
            {formatShortcut('mod', 'shift', 'O')}. O XP é contado por pasta de
            projeto.
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
