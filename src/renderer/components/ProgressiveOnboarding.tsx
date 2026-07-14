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
import {
  ENDORPHIN_STEP_LABELS,
  launchGreeting,
} from '../../shared/endorphin';
import { EndorphinPresence } from './EndorphinPresence';

/**
 * Progressive onboarding: Início → Layout → Agentes → Lançar.
 * Flag-gated; abrir sem IA é o caminho primário.
 * Endorfina: presença do pet + progresso de steps + CTA acento.
 */

type Step = 'mode' | 'layout' | 'agents' | 'preview';

const STEP_ORDER: Step[] = ['mode', 'layout', 'agents', 'preview'];

const AGENT_DIST_LABELS: Record<
  Exclude<AgentDistribution, 'none'>,
  string
> = {
  'enable-all': 'Ativar todos',
  'one-of-each': 'Um de cada',
  'split-evenly': 'Dividir igual',
};

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
  const greet = useMemo(() => launchGreeting(), []);
  const stepIndex = STEP_ORDER.indexOf(step);

  if (!flagEnabled) {
    return (
      <div className="prog-onb prog-onb--disabled" data-flag={FEATURE_FLAG_IDS.progressiveOnboarding}>
        <p>Onboarding progressivo desligado.</p>
        <button type="button" className="prog-onb__primary" onClick={onOpenTerminalOnly}>
          Abrir terminal
        </button>
      </div>
    );
  }

  return (
    <div className="prog-onb prog-onb--launch" data-testid="progressive-onboarding">
      <EndorphinPresence
        className="prog-onb__presence"
        kicker={greet.kicker}
        mood="idle"
        size={56}
      />
      <header className="prog-onb__header">
        <h1 className="prog-onb__title">{greet.title}</h1>
        <button type="button" className="prog-onb__escape" onClick={onSkip}>
          Pular · avançado
        </button>
      </header>
      {greet.line ? <p className="prog-onb__subtitle">{greet.line}</p> : null}

      <ol className="prog-onb__steps" aria-label="Progresso do lançamento">
        {STEP_ORDER.map((id, i) => (
          <li
            key={id}
            className={`prog-onb__step-dot${
              i < stepIndex ? ' is-done' : ''
            }${i === stepIndex ? ' is-active' : ''}`}
            title={ENDORPHIN_STEP_LABELS[id]}
            aria-label={ENDORPHIN_STEP_LABELS[id]}
            aria-current={i === stepIndex ? 'step' : undefined}
          />
        ))}
      </ol>

      {step === 'mode' && (
        <section className="prog-onb__step" aria-label="Modo de trabalho">
          <h2>Escolhe o ritmo</h2>
          <div className="prog-onb__grid">
            {LAUNCHER_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`prog-onb__card ${mode === mapLauncherToWork(m.id) ? 'is-active' : ''}`}
                onClick={() => setMode(mapLauncherToWork(m.id))}
              >
                <strong>{m.label}</strong>
                <span>{m.description}</span>
              </button>
            ))}
          </div>
          <div className="prog-onb__actions">
            <button type="button" className="prog-onb__primary" onClick={() => setStep('layout')}>
              Continuar
            </button>
          </div>
        </section>
      )}

      {step === 'layout' && (
        <section className="prog-onb__step" aria-label="Layout">
          <h2>Layout do terminal</h2>
          <div className="prog-onb__pane-grid" role="listbox" aria-label="Quantidade de panes">
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
                    <button type="button" onClick={() => setRecentPath(r.path)}>
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
            <button type="button" className="prog-onb__primary" onClick={() => setStep('agents')}>
              Continuar
            </button>
          </div>
        </section>
      )}

      {step === 'agents' && (
        <section className="prog-onb__step" aria-label="Agentes">
          <h2>Agentes (opcional)</h2>
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
            <button type="button" className="prog-onb__primary" onClick={() => setStep('preview')}>
              Prévia
            </button>
          </div>
        </section>
      )}

      {step === 'preview' && (
        <section className="prog-onb__step" aria-label="Prévia">
          <h2>Tudo certo — vamos</h2>
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
              {openWithoutAi ? 'Abrir e sentir o fluxo' : 'Lançar a sessão'}
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
  return id;
}
