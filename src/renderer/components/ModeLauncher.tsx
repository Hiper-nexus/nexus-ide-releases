import { LAUNCHER_MODES } from '../../shared/progressive-onboarding';

export interface ModeLauncherProps {
  readonly activeId?: string;
  readonly onSelect: (id: (typeof LAUNCHER_MODES)[number]['id']) => void;
}

/**
 * Shared shell launcher: Terminal · Missões · Enxame · Board · Memória · Skills.
 * Visual: cockpit segmented rail (ciano operacional do design system).
 */
export function ModeLauncher({ activeId, onSelect }: ModeLauncherProps) {
  return (
    <nav
      className="mode-launcher"
      data-testid="mode-launcher"
      aria-label="Modos de trabalho"
    >
      <div className="mode-launcher__track" role="presentation">
        {LAUNCHER_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`mode-launcher__item ${activeId === m.id ? 'is-active' : ''}`}
            onClick={() => onSelect(m.id)}
            title={m.description}
            aria-pressed={activeId === m.id}
          >
            <span className="mode-launcher__label">{m.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
