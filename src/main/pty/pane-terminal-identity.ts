/**
 * Identidade do terminal apresentada aos filhos dos panes.
 *
 * `TERM_PROGRAM`/`TERM_PROGRAM_VERSION` eram HERDADOS do processo do app: no
 * dev, do shell que subiu o Electron (`Termius`); no empacotado, vazio. CLIs
 * usam esses nomes para decidir integração de shell e capacidades. O pane é
 * do Nexus — ele se apresenta como Nexus, com a versão do app.
 */
export interface PaneTerminalIdentity {
  readonly name: string;
  readonly version: string;
}

export const DEFAULT_PANE_TERMINAL_IDENTITY: PaneTerminalIdentity = {
  name: 'NexusIDE',
  version: '0.0.0',
};

let identity: PaneTerminalIdentity = DEFAULT_PANE_TERMINAL_IDENTITY;

export function setPaneTerminalIdentity(next: Partial<PaneTerminalIdentity>): void {
  const name = next.name?.trim();
  const version = next.version?.trim();
  identity = {
    name: name && name.length > 0 ? name : identity.name,
    version: version && version.length > 0 ? version : identity.version,
  };
}

export function getPaneTerminalIdentity(): PaneTerminalIdentity {
  return identity;
}

/** Devolve um env NOVO com a identidade aplicada; nunca muta o recebido. */
export function applyPaneTerminalIdentity(
  env: Readonly<NodeJS.ProcessEnv>,
  current: PaneTerminalIdentity = identity,
): NodeJS.ProcessEnv {
  return {
    ...env,
    TERM_PROGRAM: current.name,
    TERM_PROGRAM_VERSION: current.version,
  };
}

export function resetPaneTerminalIdentityForTests(): void {
  identity = DEFAULT_PANE_TERMINAL_IDENTITY;
}
