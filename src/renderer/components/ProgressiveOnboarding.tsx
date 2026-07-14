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

/**
 * Progressive onboarding: Start → Layout → Agents → Launch.
 * Flag-gated; open-without-AI is the default primary path.
 * Linear-inspired density: near-black surfaces via existing CSS tokens.
 */

type Step = 'mode' | 'layout' | 'agents' | 'preview';

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

  if (!flagEnabled) {
    return (
      <div className="prog-onb prog-onb--disabled" data-flag={FEATURE_FLAG_IDS.progressiveOnboarding}>
        <p>Progressive onboarding is disabled.</p>
        <button type="button" className="prog-onb__primary" onClick={onOpenTerminalOnly}>
          Open terminal
        </button>
      </div>
    );
  }

  return (
    <div className="prog-onb prog-onb--launch" data-testid="progressive-onboarding">
      <header className="prog-onb__header">
        <h1 className="prog-onb__title">Start</h1>
        <button type="button" className="prog-onb__escape" onClick={onSkip}>
          Skip · advanced
        </button>
      </header>

      {step === 'mode' && (
        <section className="prog-onb__step" aria-label="Work mode">
          <h2>How do you want to work?</h2>
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
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 'layout' && (
        <section className="prog-onb__step" aria-label="Layout">
          <h2>Terminal layout</h2>
          <div className="prog-onb__pane-grid" role="listbox" aria-label="Pane count">
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
              <h3>Recent workspaces</h3>
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
              Back
            </button>
            <button type="button" className="prog-onb__primary" onClick={() => setStep('agents')}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 'agents' && (
        <section className="prog-onb__step" aria-label="Agents">
          <h2>Agents (optional)</h2>
          <label className="prog-onb__check">
            <input
              type="checkbox"
              checked={openWithoutAi}
              onChange={(e) => setOpenWithoutAi(e.target.checked)}
            />
            Open without AI — terminal only, no agent/MCP/account required
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
                  {d}
                </button>
              ))}
            </div>
          )}
          <div className="prog-onb__actions">
            <button type="button" onClick={() => setStep('layout')}>
              Back
            </button>
            <button type="button" className="prog-onb__primary" onClick={() => setStep('preview')}>
              Preview
            </button>
          </div>
        </section>
      )}

      {step === 'preview' && (
        <section className="prog-onb__step" aria-label="Preview">
          <h2>Launch preview</h2>
          <p className="prog-onb__summary" data-testid="launch-preview">
            {previewLaunchSummary(plan)}
          </p>
          <div className="prog-onb__actions">
            <button type="button" onClick={() => setStep('agents')}>
              Back
            </button>
            <button
              type="button"
              className="prog-onb__primary"
              data-testid="launch-primary"
              onClick={() => onLaunch(plan)}
            >
              {openWithoutAi ? 'Open terminal' : 'Launch'}
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
