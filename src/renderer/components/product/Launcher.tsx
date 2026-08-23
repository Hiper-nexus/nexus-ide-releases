import { PixelIcon, type PixelIconName } from '../PixelIcon';

export interface LauncherProps {
  onOpenWorkspace: () => void;
  onStartMission: () => void;
  onOpenTaskBoard: () => void;
  onOpenMemory: () => void;
}

interface LauncherActionProps {
  id: string;
  label: string;
  accessibleLabel: string;
  description: string;
  icon: PixelIconName;
  primary?: boolean;
  onClick: () => void;
}

function LauncherAction({
  id,
  label,
  accessibleLabel,
  description,
  icon,
  primary = false,
  onClick,
}: LauncherActionProps) {
  const descriptionId = `launcher-action-${id}-description`;

  return (
    <button
      type="button"
      className={`launcher-action${
        primary ? ' launcher-action--primary' : ''
      }`}
      data-launcher-action={id}
      aria-label={accessibleLabel}
      aria-describedby={descriptionId}
      onClick={onClick}
    >
      <span className="launcher-action__icon" aria-hidden="true">
        <PixelIcon name={icon} size={16} />
      </span>
      <span className="launcher-action__copy">
        <strong className="launcher-action__label">{label}</strong>
        <span id={descriptionId} className="launcher-action__description">
          {description}
        </span>
      </span>
      <span className="launcher-action__direction" aria-hidden="true">
        <PixelIcon name="arrow-right" size={12} />
      </span>
    </button>
  );
}

/** Quiet entry surface: one prompt, one emphasized path and three alternatives. */
export function Launcher({
  onOpenWorkspace,
  onStartMission,
  onOpenTaskBoard,
  onOpenMemory,
}: LauncherProps) {
  return (
    <section className="launcher" aria-labelledby="launcher-title">
      <div className="launcher__content">
        <header className="launcher__header">
          <h1 id="launcher-title" className="launcher__title">
            O que você quer fazer agora?
          </h1>
        </header>

        <div
          className="launcher__actions"
          role="group"
          aria-label="Ações iniciais"
        >
          <LauncherAction
            id="mission"
            label="Missão em equipe"
            accessibleLabel="Missão em equipe"
            description="Descreva o que você quer entregar e o Nexus organiza o trabalho."
            icon="mission"
            primary
            onClick={onStartMission}
          />
          <LauncherAction
            id="workspace"
            label="Abrir uma pasta de projeto"
            accessibleLabel="Abrir uma pasta de projeto"
            description="Já tenho arquivos no computador e quero trabalhar em cima deles."
            icon="files"
            onClick={onOpenWorkspace}
          />
          <LauncherAction
            id="task-board"
            label="Quadro"
            accessibleLabel="Abrir Quadro"
            description="Acompanhe tarefas e organize o que vem a seguir."
            icon="board"
            onClick={onOpenTaskBoard}
          />
          <LauncherAction
            id="memory"
            label="Memória"
            accessibleLabel="Abrir Memória"
            description="Consulte notas locais, decisões e referências do projeto."
            icon="file"
            onClick={onOpenMemory}
          />
        </div>
      </div>
    </section>
  );
}
