import { useMemo, useState } from 'react';
import {
  AGENT_DISTRIBUTION,
  LAYOUT_PANE_COUNTS,
  LAUNCHER_MODES,
  previewLaunchSummary,
  progressiveLaunchSchema,
  type AgentDistribution,
  type LayoutPaneCount,
  type ProgressiveLaunch,
  type WorkMode,
} from '../../shared/progressive-onboarding';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { launchGreeting } from '../../shared/endorphin';
import { EndorphinPresence } from './EndorphinPresence';
import { formatShortcut } from '../lib/platform';

/**
 * Progressive onboarding: Início → Layout → Agentes → Lançar.
 * Visual inspired by BridgeMind workspace create (clean-room): hero, step
 * trail, recommended/advanced featured cards, secondary escape.
 * Endorfina: presença do pet + saudação de lançamento + CTA acento.
 */

type Step = 'mode' | 'layout' | 'agents' | 'preview';

const STEPS: { id: Step; label: string }[] = [
  { id: 'mode', label: 'Início' },
  { id: 'layout', label: 'Layout' },
  { id: 'agents', label: 'Agentes' },
  { id: 'preview', label: 'Lançar' },
];

const AGENT_DIST_LABELS: Record<
  Exclude<AgentDistribution, 'none'>,
  string
> = {
  'enable-all': 'Ativar todos',
  'one-of-each': 'Um de cada',
  'split-evenly': 'Dividir igual',
};

/** Featured pair — BridgeSpace / BridgeSwarm analogue. */
const FEATURED = [
  {
    launcherId: 'terminal' as const,
    workMode: 'terminal-only' as WorkMode,
    title: 'Nexus Space',
    description:
      'Grade limpa de terminais. Ideal pro dia a dia — com ou sem IA.',
    cta: 'Continuar',
    badge: 'recomendado' as const,
    icon: 'terminal' as PixelIconName,
  },
  {
    launcherId: 'swarm' as const,
    workMode: 'swarm' as WorkMode,
    title: 'Nexus Squad',
    description:
      'Um time de agentes no mesmo objetivo — planejar, construir e revisar em paralelo.',
    cta: 'Montar squad',
    badge: 'avancado' as const,
    icon: 'users' as PixelIconName,
  },
] as const;

const SECONDARY_IDS = new Set(['missions', 'board', 'memory', 'skills']);

export interface ProgressiveOnboardingProps {
  readonly flagEnabled?: boolean;
  readonly recents?: readonly { path: string; label?: string }[];
  readonly onLaunch: (plan: ProgressiveLaunch) => void;
  readonly onSkip: () => void;
  readonly onOpenTerminalOnly: () => void;
}

export function ProgressiveOnboarding({
  flagEnabled = true,
  recents = [],
  onLaunch,
  onSkip,
  onOpenTerminalOnly,
}: ProgressiveOnboardingProps) {
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<WorkMode>('terminal-only');
  const [paneCount, setPaneCount] = useState<LayoutPaneCount>(1);
  const [agentDistribution, setAgentDistribution] =
    useState<AgentDistribution>('none');
  const [openWithoutAi, setOpenWithoutAi] = useState(true);
  const [recentPath, setRecentPath] = useState<string | undefined>();

  const plan = useMemo(
    () =>
      progressiveLaunchSchema.parse({
        mode,
        paneCount,
        agentDistribution: openWithoutAi ? 'none' : agentDistribution,
        openWithoutAi,
        recentWorkspacePath: recentPath,
      }),
    [mode, paneCount, agentDistribution, openWithoutAi, recentPath],
  );

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const greet = useMemo(() => launchGreeting(), []);

  if (!flagEnabled) {
    return (
      <div
        className="prog-onb prog-onb--disabled"
        data-flag={FEATURE_FLAG_IDS.progressiveOnboarding}
      >
        <p>Onboarding progressivo desligado.</p>
        <button
          type="button"
          className="prog-onb__primary"
          onClick={onOpenTerminalOnly}
        >
          Abrir terminal
        </button>
      </div>
    );
  }

  return (
    <div
      className="prog-onb prog-onb--launch prog-onb--hero"
      data-testid="progressive-onboarding"
    >
      <nav className="prog-onb__trail" aria-label="Etapas do início">
        {STEPS.map((s, i) => {
          const state =
            i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo';
          return (
            <div
              key={s.id}
              className={`prog-onb__trail-item prog-onb__trail-item--${state}`}
            >
              <span className="prog-onb__trail-dot" aria-hidden="true">
                {i < stepIndex ? '✓' : i + 1}
              </span>
              <span className="prog-onb__trail-label">{s.label}</span>
              {i < STEPS.length - 1 && (
                <span className="prog-onb__trail-line" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </nav>

      <header className="prog-onb__hero">
        <EndorphinPresence
          className="prog-onb__presence"
          kicker={greet.kicker}
          mood="idle"
          size={56}
        />
        <button type="button" className="prog-onb__escape" onClick={onSkip}>
          Pular · avançado
        </button>
        <h1 className="prog-onb__title">
          {step === 'mode' && greet.title}
          {step === 'layout' && 'Layout do terminal'}
          {step === 'agents' && 'Agentes (opcional)'}
          {step === 'preview' && 'Tudo certo — vamos'}
        </h1>
        <p className="prog-onb__subtitle">
          {step === 'mode' &&
            (greet.line || 'Escolha como quer trabalhar. Pode mudar depois.')}
          {step === 'layout' &&
            'Quantos panes abrem no grid? Escolha um workspace recente ou continue.'}
          {step === 'agents' &&
            'Pode abrir só o terminal — ou distribuir agentes nas CLIs instaladas.'}
          {step === 'preview' && 'Confira o plano e lance quando estiver pronto.'}
        </p>
      </header>

      {step === 'mode' && (
        <section className="prog-onb__step" aria-label="Modo de trabalho">
          <div className="prog-onb__featured">
            {FEATURED.map((card) => {
              const active = mode === card.workMode;
              return (
                <button
                  key={card.launcherId}
                  type="button"
                  className={[
                    'prog-onb__feature-card',
                    `prog-onb__feature-card--${card.badge}`,
                    active ? 'is-active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    setMode(card.workMode);
                    if (card.workMode === 'terminal-only') {
                      setOpenWithoutAi(true);
                      setAgentDistribution('none');
                    } else if (card.workMode === 'swarm') {
                      setOpenWithoutAi(false);
                      setAgentDistribution('one-of-each');
                    }
                    // Featured CTA advances (Bridge-style card = action).
                    setStep('layout');
                  }}
                >
                  <div className="prog-onb__feature-top">
                    <span className="prog-onb__feature-icon" aria-hidden="true">
                      <PixelIcon name={card.icon} size={18} />
                    </span>
                    <span
                      className={`prog-onb__badge prog-onb__badge--${card.badge}`}
                    >
                      {card.badge === 'recomendado' ? '✦ Recomendado' : 'Avançado'}
                    </span>
                  </div>
                  <strong className="prog-onb__feature-title">{card.title}</strong>
                  <p className="prog-onb__feature-desc">{card.description}</p>
                  <span className="prog-onb__feature-cta">
                    {card.cta} ›
                  </span>
                </button>
              );
            })}
          </div>

          <div className="prog-onb__secondary" aria-label="Outros modos">
            {LAUNCHER_MODES.filter((m) => SECONDARY_IDS.has(m.id)).map((m) => {
              const work = mapLauncherToWork(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`prog-onb__chip ${mode === work ? 'is-active' : ''}`}
                  onClick={() => setMode(work)}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <div className="prog-onb__actions prog-onb__actions--split">
            <button
              type="button"
              className="prog-onb__ghost-terminal"
              onClick={onOpenTerminalOnly}
            >
              <PixelIcon name="terminal" size={12} />
              <span>Abrir um terminal só</span>
              <kbd className="prog-onb__kbd">{formatShortcut('mod', 'N')}</kbd>
            </button>
            <button
              type="button"
              className="prog-onb__primary"
              onClick={() => setStep('layout')}
            >
              Continuar ›
            </button>
          </div>
        </section>
      )}

      {step === 'layout' && (
        <section className="prog-onb__step" aria-label="Layout">
          <div
            className="prog-onb__pane-grid"
            role="listbox"
            aria-label="Quantidade de panes"
          >
            {LAYOUT_PANE_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={paneCount === n}
                className={`prog-onb__pane ${paneCount === n ? 'is-active' : ''}`}
                onClick={() => setPaneCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
          {recents.length > 0 && (
            <div className="prog-onb__recents">
              <h3>Workspaces recentes</h3>
              <ul>
                {recents.slice(0, 5).map((r) => (
                  <li key={r.path}>
                    <button
                      type="button"
                      className={
                        recentPath === r.path ? 'is-selected' : undefined
                      }
                      onClick={() => setRecentPath(r.path)}
                    >
                      {r.label ?? r.path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="prog-onb__actions">
            <button type="button" onClick={() => setStep('mode')}>
              Voltar
            </button>
            <button
              type="button"
              className="prog-onb__primary"
              onClick={() => setStep('agents')}
            >
              Continuar ›
            </button>
          </div>
        </section>
      )}

      {step === 'agents' && (
        <section className="prog-onb__step" aria-label="Agentes">
          <label className="prog-onb__check">
            <input
              type="checkbox"
              checked={openWithoutAi}
              onChange={(e) => setOpenWithoutAi(e.target.checked)}
            />
            Abrir sem IA — só terminal, sem agente/MCP/conta
          </label>
          {!openWithoutAi && (
            <div className="prog-onb__agent-ops">
              {AGENT_DISTRIBUTION.filter((d) => d !== 'none').map((d) => (
                <button
                  key={d}
                  type="button"
                  className={agentDistribution === d ? 'is-active' : ''}
                  onClick={() => setAgentDistribution(d)}
                >
                  {AGENT_DIST_LABELS[d]}
                </button>
              ))}
            </div>
          )}
          <div className="prog-onb__actions">
            <button type="button" onClick={() => setStep('layout')}>
              Voltar
            </button>
            <button
              type="button"
              className="prog-onb__primary"
              onClick={() => setStep('preview')}
            >
              Prévia ›
            </button>
          </div>
        </section>
      )}

      {step === 'preview' && (
        <section className="prog-onb__step" aria-label="Prévia">
          <p className="prog-onb__summary" data-testid="launch-preview">
            {previewLaunchSummary(plan)}
          </p>
          <div className="prog-onb__actions">
            <button type="button" onClick={() => setStep('agents')}>
              Voltar
            </button>
            <button
              type="button"
              className="prog-onb__primary"
              data-testid="launch-primary"
              onClick={() => onLaunch(plan)}
            >
              {openWithoutAi ? 'Abrir e sentir o fluxo' : 'Lançar a sessão'} ›
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function mapLauncherToWork(
  id: (typeof LAUNCHER_MODES)[number]['id'],
): WorkMode {
  if (id === 'terminal') return 'terminal-only';
  if (id === 'marketplace') return 'skills';
  return id;
}
