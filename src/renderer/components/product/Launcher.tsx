import { PixelIcon, type PixelIconName } from '../PixelIcon';

export interface LauncherProps {
  onOpenWorkspace: () => void;
  onStartMission: () => void;
  onOpenPane: () => void;
  onOpenShellTerminal: () => void;
  onOpenTaskBoard: () => void;
  onOpenMemory: () => void;
  onOpenProviders: () => void;
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
      className={`launcher-action${primary ? ' launcher-action--primary' : ''}`}
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

function LauncherGuide({
  onOpenProviders,
}: Pick<LauncherProps, 'onOpenProviders'>) {
  return (
    <aside className="launcher__guide" aria-labelledby="launcher-guide-title">
      <h2 id="launcher-guide-title" className="launcher__section-title">
        Do pedido à entrega
      </h2>
      <ol className="launcher__steps">
        <li>
          <strong>Conte sua ideia</strong>
          <p>Diga o que precisa e como vai saber que ficou pronto.</p>
        </li>
        <li>
          <strong>Prepare o projeto</strong>
          <p>Escolha a pasta e confira as IAs que vão trabalhar com você.</p>
        </li>
        <li>
          <strong>Acompanhe e revise</strong>
          <p>
            Veja o progresso, confira o resultado e peça ajustes quando
            precisar.
          </p>
        </li>
      </ol>
      <button
        type="button"
        className="launcher__connect"
        onClick={onOpenProviders}
      >
        Conectar uma IA <PixelIcon name="arrow-right" size={12} />
      </button>
      <p className="launcher__note">
        Se você já usa uma IA no computador, confira a conexão antes de começar.
      </p>
    </aside>
  );
}

function LauncherTools({
  onOpenPane,
  onOpenShellTerminal,
  onOpenTaskBoard,
  onOpenMemory,
}: Pick<
  LauncherProps,
  'onOpenPane' | 'onOpenShellTerminal' | 'onOpenTaskBoard' | 'onOpenMemory'
>) {
  return (
    <>
      <section
        className="launcher__terminals"
        aria-labelledby="launcher-terminals-title"
      >
        <h2 id="launcher-terminals-title" className="launcher__section-title" tabIndex={-1}>
          Prefere trabalhar nos terminais?
        </h2>
        <p className="launcher__intro">
          Abra seus próprios painéis e escolha uma ferramenta para cada um.
        </p>
        <div className="launcher__terminal-actions">
          <LauncherAction
            id="pane"
            label="Montar meus terminais"
            accessibleLabel="Montar meus terminais"
            description="Escolha a pasta, a quantidade de painéis e as IAs."
            icon="grid"
            onClick={onOpenPane}
          />
          <LauncherAction
            id="shell"
            label="Terminal sem IA"
            accessibleLabel="Abrir terminal sem IA"
            description="Use comandos diretamente, sem assistente."
            icon="terminal"
            onClick={onOpenShellTerminal}
          />
        </div>
      </section>

      <details className="launcher__organize">
        <summary>Organizar tarefas e consultar notas</summary>
        <div className="launcher__terminal-actions">
          <LauncherAction
            id="task-board"
            label="Quadro de tarefas"
            accessibleLabel="Abrir Quadro de tarefas"
            description="Organize o que vem a seguir no projeto."
            icon="board"
            onClick={onOpenTaskBoard}
          />
          <LauncherAction
            id="memory"
            label="Memória do projeto"
            accessibleLabel="Abrir Memória do projeto"
            description="Consulte notas, decisões e referências."
            icon="file"
            onClick={onOpenMemory}
          />
        </div>
      </details>
    </>
  );
}

/** Entry guidance uses the real project, mission and terminal flows. */
export function Launcher({
  onOpenWorkspace,
  onStartMission,
  onOpenPane,
  onOpenShellTerminal,
  onOpenTaskBoard,
  onOpenMemory,
  onOpenProviders,
}: LauncherProps) {
  return (
    <section className="launcher" aria-labelledby="launcher-title">
      <div className="launcher__content">
        <header className="launcher__header">
          <h1 id="launcher-title" className="launcher__title">
            O que você quer criar?
          </h1>
          <p className="launcher__intro">
            Um site, aplicativo ou uma melhoria no projeto que você já tem.
            Comece pelo resultado que quer alcançar.
          </p>
          <a className="launcher__quick-terminal" href="#launcher-terminals-title">
            Ir direto para os terminais
          </a>
        </header>

        <div className="launcher__welcome">
          <section className="launcher__start" aria-label="Começar um projeto">
            <h2 className="launcher__section-title">
              Trabalhe com uma equipe de IAs
            </h2>
            <p className="launcher__intro">
              No Nexus, um trabalho com IA é uma missão. Você descreve o
              objetivo, acompanha o que está sendo feito e revisa a entrega.
            </p>
            <div className="launcher__actions">
              <LauncherAction
                id="pane"
                label="Montar meus terminais"
                accessibleLabel="Montar meus terminais"
                description="Inicie direto com grade de terminais e escolha suas IAs."
                icon="grid"
                primary
                onClick={onOpenPane}
              />
              <LauncherAction
                id="mission"
                label="Criar com IA"
                accessibleLabel="Criar com IA"
                description="Conte sua ideia e prepare uma missão."
                icon="mission"
                onClick={onStartMission}
              />
              <LauncherAction
                id="workspace"
                label="Abrir projeto existente"
                accessibleLabel="Abrir projeto existente"
                description="Escolha uma pasta do computador para continuar de onde parou."
                icon="files"
                onClick={onOpenWorkspace}
              />
            </div>
          </section>

          <LauncherGuide onOpenProviders={onOpenProviders} />
        </div>

        <LauncherTools
          onOpenPane={onOpenPane}
          onOpenShellTerminal={onOpenShellTerminal}
          onOpenTaskBoard={onOpenTaskBoard}
          onOpenMemory={onOpenMemory}
        />
      </div>
    </section>
  );
}
