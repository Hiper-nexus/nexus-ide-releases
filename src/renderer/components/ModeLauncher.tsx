import { LAUNCHER_MODES } from '../../shared/progressive-onboarding';

export interface ModeLauncherProps {
  readonly activeId?: string;
  readonly onSelect: (id: (typeof LAUNCHER_MODES)[number]['id']) => void;
}

/**
 * Shared shell launcher: Terminal · Missions · Swarm · Board · Memory · Skills.
 */
export function ModeLauncher({ activeId, onSelect }: ModeLauncherProps) {
  return (
    <nav className="mode-launcher" data-testid="mode-launcher" aria-label="Modes">
      {LAUNCHER_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`mode-launcher__item ${activeId === m.id ? 'is-active' : ''}`}
          onClick={() => onSelect(m.id)}
          title={m.description}
        >
          <span className="mode-launcher__label">{m.label}</span>
        </button>
      ))}
    </nav>
  );
}
