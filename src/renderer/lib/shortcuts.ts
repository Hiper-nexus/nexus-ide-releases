import { formatShortcut } from './platform';
import {
  commandShortcutLabel,
  isKeybindingCommand,
  type KeybindingOverrides,
} from './keybindings';

/**
 * Catálogo ÚNICO de atalhos. Antes existiam três listas independentes —
 * KeyboardCheatsheet, Configurações › Atalhos e o rodapé do Home — que
 * discordavam entre si, e ⌘⇧N (missão rápida) não estava em nenhuma delas
 * apesar de existir desde sempre em App.tsx.
 *
 * Regra: todo handler global registrado em App.tsx precisa de uma entrada
 * aqui, com o mesmo `id`. `shortcuts-contract.test.ts` falha se um handler
 * existir sem entrada (ou o contrário).
 *
 * `keys` é sempre construído com `formatShortcut` — ⌘ literal em string é
 * dívida cross-platform (DESIGN.md §7).
 */

export type ShortcutGroupId = 'command' | 'fleet' | 'surfaces';

export interface ShortcutEntry {
  /** Estável; espelha o handler que o implementa. */
  readonly id: string;
  readonly keys: string;
  readonly action: string;
  readonly group: ShortcutGroupId;
  /** Exibido no rodapé compacto do Home (espaço curto — só o essencial). */
  readonly primary?: boolean;
  /** Rótulo de uma palavra para o rodapé; `action` não cabe lá. */
  readonly short?: string;
}

export const SHORTCUT_GROUP_LABELS: Readonly<
  Record<ShortcutGroupId, string>
> = Object.freeze({
  command: 'Comando',
  fleet: 'Frota',
  surfaces: 'Superfícies',
});

export const SHORTCUTS: readonly ShortcutEntry[] = Object.freeze([
  Object.freeze({
    id: 'command-palette',
    keys: formatShortcut('mod', 'K'),
    action: 'Buscar terminais, missões e ações',
    group: 'command' as const,
    primary: true,
    short: 'comandos',
  }),
  Object.freeze({
    id: 'file-picker',
    keys: formatShortcut('mod', 'P'),
    action: 'Ir para um arquivo do projeto',
    group: 'command' as const,
  }),
  Object.freeze({
    id: 'content-search',
    keys: formatShortcut('mod', 'shift', 'F'),
    action: 'Buscar texto nos arquivos do projeto (na paleta, ou sem terminal selecionado)',
    group: 'command' as const,
  }),
  Object.freeze({
    id: 'mission-new',
    keys: formatShortcut('mod', 'N'),
    action: 'Nova missão',
    group: 'command' as const,
    primary: true,
    short: 'missão',
  }),
  Object.freeze({
    id: 'attention-inbox',
    keys: formatShortcut('mod', 'J'),
    action: 'Lista de atenção: Enter, PR, missão, login',
    group: 'command' as const,
    primary: true,
    short: 'atenção',
  }),
  Object.freeze({
    id: 'task-board',
    keys: formatShortcut('mod', 'B'),
    action: 'Missões e tarefas',
    group: 'command' as const,
  }),
  Object.freeze({
    id: 'settings',
    keys: formatShortcut('mod', ','),
    action: 'Configurações',
    group: 'command' as const,
  }),
  Object.freeze({
    id: 'cheatsheet',
    keys: formatShortcut('mod', '/'),
    action: 'Esta lista de atalhos',
    group: 'command' as const,
  }),
  Object.freeze({
    id: 'focus-pane-n',
    keys: formatShortcut('mod', '1-9'),
    action: 'Selecionar um terminal pelo número',
    group: 'fleet' as const,
    primary: true,
    short: 'focar',
  }),
  Object.freeze({
    id: 'cycle-pane',
    keys: 'Ctrl+Tab / Ctrl+Shift+Tab',
    action: 'Ir para o próximo ou o terminal anterior',
    group: 'fleet' as const,
    primary: true,
    short: 'circular',
  }),
  Object.freeze({
    id: 'cycle-tab',
    keys: `${formatShortcut('mod', 'alt', '→')} / ${formatShortcut('mod', 'alt', '←')}`,
    action: 'Ir para a próxima ou a aba anterior dos Terminais',
    group: 'fleet' as const,
  }),
  Object.freeze({
    id: 'split-right',
    keys: formatShortcut('mod', 'D'),
    action: 'Dividir o terminal à direita',
    group: 'fleet' as const,
    primary: true,
    short: 'dividir',
  }),
  Object.freeze({
    id: 'split-down',
    keys: formatShortcut('mod', 'shift', 'D'),
    action: 'Dividir o terminal abaixo',
    group: 'fleet' as const,
  }),
  Object.freeze({
    id: 'close-pane',
    keys: formatShortcut('mod', 'W'),
    action: 'Fechar o terminal selecionado',
    group: 'fleet' as const,
  }),
  Object.freeze({
    id: 'rename-pane',
    keys: 'duplo-clique',
    action: 'Renomear o terminal (no título)',
    group: 'fleet' as const,
  }),
  Object.freeze({
    id: 'operator-profile',
    keys: formatShortcut('mod', 'shift', 'O'),
    action: 'Perfil do Operador',
    group: 'surfaces' as const,
  }),
  Object.freeze({
    id: 'bug-report',
    keys: formatShortcut('mod', 'shift', 'B'),
    action: 'Reportar um problema (em qualquer tela)',
    group: 'surfaces' as const,
  }),
  Object.freeze({
    id: 'dismiss-overlay',
    keys: 'Esc',
    action: 'Fechar o painel ou diálogo aberto',
    group: 'surfaces' as const,
  }),
  Object.freeze({
    id: 'voice-dictate',
    keys: 'Space (segurar)',
    action: 'Ditado no terminal selecionado (preset NexusVoice)',
    group: 'surfaces' as const,
  }),
  Object.freeze({
    id: 'voice-push-to-talk',
    keys: formatShortcut('mod', 'shift', 'Space'),
    action: 'Falar com a assistente (atalho global)',
    group: 'surfaces' as const,
  }),
]);

const SHORTCUTS_BY_ID: ReadonlyMap<string, ShortcutEntry> = new Map(
  SHORTCUTS.map((entry) => [entry.id, entry]),
);

/** Lookup por id estável — preferir isto a hardcodar `formatShortcut` na UI. */
export function shortcutById(id: string): ShortcutEntry | undefined {
  return SHORTCUTS_BY_ID.get(id);
}

/** Chord formatado do catálogo, ou `undefined` se o id não existir. */
export function shortcutKeys(id: string): string | undefined {
  return SHORTCUTS_BY_ID.get(id)?.keys;
}

/** Atalhos de um grupo, na ordem declarada. */
export function shortcutsInGroup(
  group: ShortcutGroupId,
): readonly ShortcutEntry[] {
  return SHORTCUTS.filter((entry) => entry.group === group);
}

/**
 * Chord exibido de uma entrada: o efetivo quando o atalho é remapeável em
 * Configurações › Atalhos (`keys` guarda só o padrão), o fixo nos demais.
 */
export function effectiveShortcutKeys(
  entry: ShortcutEntry,
  overrides?: KeybindingOverrides,
): string {
  if (!isKeybindingCommand(entry.id)) return entry.keys;
  return commandShortcutLabel(entry.id, overrides) ?? 'sem atalho';
}

/** Subconjunto do rodapé do Home: os atalhos `primary` do catálogo. */
export function primaryShortcuts(): readonly ShortcutEntry[] {
  return SHORTCUTS.filter((entry) => entry.primary === true);
}

/** IDs dos atalhos servidos por um handler global de App.tsx. */
export const GLOBAL_HANDLER_SHORTCUT_IDS: readonly string[] = Object.freeze([
  'settings',
  'operator-profile',
  'bug-report',
  'task-board',
  'command-palette',
  'file-picker',
  'content-search',
  'cheatsheet',
  'mission-new',
  'attention-inbox',
  'focus-pane-n',
  'split-right',
  'split-down',
  'close-pane',
]);
