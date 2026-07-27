import { useMemo } from 'react';
import {
  progressiveLaunchSchema,
  type ProgressiveLaunch,
} from '../../shared/progressive-onboarding';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { launchGreeting } from '../../shared/endorphin';
import { formatShortcut } from '../lib/platform';
import { EndorphinPresence } from './EndorphinPresence';
import { PixelIcon } from './PixelIcon';

/**
 * First-run entry is deliberately mission-first: choose a workspace, describe
 * the outcome and review the generated team. Pane topology and CLI tuning stay
 * in the explicit advanced path instead of becoming beginner prerequisites.
 */

export interface ProgressiveOnboardingProps {
  readonly flagEnabled?: boolean;
  readonly recents?: readonly { path: string; label?: string }[];
  readonly onLaunch: (plan: ProgressiveLaunch) => void;
  readonly onSkip: () => void;
  readonly onOpenTerminalOnly: () => void;
}

function missionPlan(recentWorkspacePath?: string): ProgressiveLaunch {
  return progressiveLaunchSchema.parse({
    mode: 'missions',
    paneCount: 1,
    agentDistribution: 'one-of-each',
    openWithoutAi: false,
    recentWorkspacePath,
  });
}

export function ProgressiveOnboarding({
  flagEnabled = true,
  recents = [],
  onLaunch,
  onSkip,
  onOpenTerminalOnly,
}: ProgressiveOnboardingProps) {
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
      className="prog-onb prog-onb--launch"
      data-testid="progressive-onboarding"
    >
      <header className="prog-onb__hero">
        <EndorphinPresence
          className="prog-onb__presence"
          kicker={greet.kicker}
          mood="idle"
          size={56}
        />
        <h1 className="prog-onb__title">{greet.title}</h1>
        <p className="prog-onb__subtitle">
          Diga o que precisa entregar. O Nexus prepara o time, mostra a rota
          exata e pede uma única aprovação antes de executar.
        </p>
      </header>

      <section className="prog-onb__start" aria-label="Começar no Nexus">
        <button
          type="button"
          className="prog-onb__mission-start"
          data-testid="launch-primary"
          onClick={() => onLaunch(missionPlan())}
        >
          <span className="prog-onb__mission-icon" aria-hidden="true">
            <PixelIcon name="mission" size={18} />
          </span>
          <span className="prog-onb__mission-copy">
            <strong>Começar uma missão</strong>
            <span>Escolher workspace e descrever o objetivo</span>
          </span>
          <PixelIcon name="chevron" size={14} />
        </button>

        {recents.length > 0 && (
          <div className="prog-onb__recents">
            <p className="prog-onb__section-label">WORKSPACES RECENTES</p>
            <ul>
              {recents.slice(0, 5).map((recent) => (
                <li key={recent.path}>
                  <button
                    type="button"
                    onClick={() => onLaunch(missionPlan(recent.path))}
                    title={recent.path}
                  >
                    <PixelIcon name="files" size={12} />
                    <span>{recent.label ?? recent.path}</span>
                    <PixelIcon name="chevron" size={11} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="prog-onb__actions prog-onb__actions--split">
          <button
            type="button"
            className="prog-onb__ghost-terminal"
            onClick={onOpenTerminalOnly}
          >
            <PixelIcon name="terminal" size={12} />
            <span>Abrir só o terminal</span>
            <kbd className="prog-onb__kbd">{formatShortcut('mod', 'N')}</kbd>
          </button>
          <button
            type="button"
            className="prog-onb__advanced"
            onClick={onSkip}
          >
            Configuração avançada
          </button>
        </div>
      </section>
    </div>
  );
}
