/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Reference: apps/web/src/keybindings.ts, editableFocus shortcut context.
 * Nexus-specific action names, number keys and existing launcher callbacks.
 */
/**
 * Nomes de ação acessíveis + atalhos (itens T3 "acessibilidade de nomes de
 * ação" e "atalhos do launcher").
 *
 * Toda ação de superfície tem um NOME ACESSÍVEL estável (nunca só ícone) e
 * um atalho opcional. O registry é a fonte única: UI e testes leem daqui,
 * então uma ação sem nome acessível não passa no contrato.
 */

export interface ActionNameEntry {
  /** id estável (data-action / data-launcher-action). */
  readonly id: string;
  /** Texto visível curto. */
  readonly label: string;
  /** Nome lido por leitor de tela — completo, sem depender do ícone. */
  readonly accessibleName: string;
  /** Atalho de teclado (ex.: '1', 'k'). Vazio = sem atalho. */
  readonly shortcut: string;
  /** Descrição longa para aria-describedby. */
  readonly description?: string;
}

/** Ações do launcher de entrada (ordem = ordem de tab/atalho). */
export const LAUNCHER_ACTIONS: readonly ActionNameEntry[] = [
  {
    id: 'pane',
    label: 'Montar meus terminais',
    accessibleName: 'Montar meus terminais: abrir a grade de terminais e escolher as IAs',
    shortcut: '1',
    description: 'Inicie direto com grade de terminais e escolha suas IAs.',
  },
  {
    id: 'mission',
    label: 'Criar com IA',
    accessibleName: 'Criar com IA: iniciar uma missão a partir da sua ideia',
    shortcut: '2',
    description: 'Conte sua ideia e prepare uma missão.',
  },
  {
    id: 'workspace',
    label: 'Abrir projeto existente',
    accessibleName: 'Abrir projeto existente: escolher uma pasta do computador',
    shortcut: '3',
    description: 'Escolha uma pasta do computador para continuar de onde parou.',
  },
  {
    id: 'shell',
    label: 'Terminal sem IA',
    accessibleName: 'Terminal sem IA: abrir um terminal só com shell',
    shortcut: '4',
    description: 'Abre um terminal limpo, sem agente.',
  },
  {
    id: 'tasks',
    label: 'Quadro de tarefas',
    accessibleName: 'Quadro de tarefas: ver e organizar o trabalho da missão',
    shortcut: '5',
    description: 'Acompanhe o que falta e o que já foi entregue.',
  },
  {
    id: 'memory',
    label: 'Memória do projeto',
    accessibleName: 'Memória do projeto: ver o que o Nexus guardou',
    shortcut: '6',
    description: 'Preferências, decisões e notas que atravessam sessões.',
  },
];

/**
 * F-1171: importar os transcripts das CLIs para o histórico de comandos.
 * Menu de comandos do pane e paleta leem o mesmo nome.
 */
export const CLI_HISTORY_IMPORT_ACTION: ActionNameEntry = {
  id: 'cli-history-import',
  label: 'Importar histórico das CLIs',
  accessibleName:
    'Importar histórico das CLIs: trazer os comandos de shell dos agentes deste projeto para o histórico',
  shortcut: '',
  description:
    'Lê as conversas das CLIs deste projeto e grava os comandos no histórico, sem duplicar.',
};

const byId = new Map(LAUNCHER_ACTIONS.map((entry) => [entry.id, entry]));

export function launcherAction(id: string): ActionNameEntry | null {
  return byId.get(id) ?? null;
}

/**
 * Nome acessível obrigatório: uma ação sem `accessibleName` não entra.
 * Ícone sozinho nunca satisfaz o contrato.
 */
export function requireAccessibleName(entry: {
  readonly accessibleName?: string | null;
  readonly label?: string | null;
  readonly id: string;
}): string {
  const name = entry.accessibleName?.trim();
  if (name && name.length > 0) return name;
  const label = entry.label?.trim();
  if (label && label.length > 0) return label;
  throw new Error(
    `action ${entry.id} has no accessible name (icon-only actions are not allowed)`,
  );
}

/** Mapeia tecla pressionada → id de ação do launcher (só quando o alvo não é input). */
export function launcherActionIdForKey(
  key: string,
  options: { readonly targetIsEditable?: boolean } = {},
): string | null {
  if (options.targetIsEditable === true) return null;
  const hit = LAUNCHER_ACTIONS.find((entry) => entry.shortcut === key);
  return hit?.id ?? null;
}

export function launcherShortcutHint(id: string): string | null {
  return byId.get(id)?.shortcut ?? null;
}
