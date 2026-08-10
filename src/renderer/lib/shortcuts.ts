import { formatShortcut } from './platform';

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
  /** Só faz sentido nesta view; o rodapé do Home filtra por isto. */
  readonly viewKind?: 'grid' | 'canvas';
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
    action: 'Command palette: panes, missões e ações',
    group: 'command' as const,
    primary: true,
    short: 'comandos',
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
    id: 'task-board',
    keys: formatShortcut('mod', 'B'),
    action: 'Quadro de tarefas',
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
    action: 'Focar o N-ésimo pane',
    group: 'fleet' as const,
    primary: true,
    short: 'focar',
  }),
  Object.freeze({
    id: 'split-right',
    keys: formatShortcut('mod', 'D'),
    action: 'Dividir o pane à direita',
    group: 'fleet' as const,
    primary: true,
    short: 'dividir',
    viewKind: 'grid' as const,
  }),
  Object.freeze({
    id: 'split-down',
    keys: formatShortcut('mod', 'shift', 'D'),
    action: 'Dividir o pane abaixo',
    group: 'fleet' as const,
    viewKind: 'grid' as const,
  }),
  Object.freeze({
    id: 'close-pane',
    keys: formatShortcut('mod', 'W'),
    action: 'Fechar o pane focado',
    group: 'fleet' as const,
  }),
  Object.freeze({
    id: 'rename-pane',
    keys: 'duplo-clique',
    action: 'Renomear o pane (no título)',
    group: 'fleet' as const,
  }),
  Object.freeze({
    id: 'operator-profile',
    keys: formatShortcut('mod', 'shift', 'O'),
    action: 'Perfil do Operador',
    group: 'surfaces' as const,
  }),
  Object.freeze({
    id: 'dismiss-overlay',
    keys: 'Esc',
    action: 'Fechar overlay/dialog em foco',
    group: 'surfaces' as const,
  }),
  Object.freeze({
    id: 'canvas-center',
    keys: 'F',
    action: 'Centralizar o canvas',
    group: 'surfaces' as const,
    primary: true,
    short: 'centralizar',
    viewKind: 'canvas' as const,
  }),
  Object.freeze({
    id: 'voice-dictate',
    keys: 'Space (segurar)',
    action: 'Ditado no pane focado (preset NexusVoice)',
    group: 'surfaces' as const,
  }),
  Object.freeze({
    id: 'voice-push-to-talk',
    keys: formatShortcut('mod', 'shift', 'Space'),
    action: 'Push-to-talk Jarvis (padrão global)',
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
 * Subconjunto do rodapé do Home: só os `primary` aplicáveis à view corrente.
 * Um atalho sem `viewKind` vale nas duas.
 */
export function primaryShortcuts(
  viewKind: 'grid' | 'canvas',
): readonly ShortcutEntry[] {
  return SHORTCUTS.filter(
    (entry) =>
      entry.primary === true &&
      (entry.viewKind === undefined || entry.viewKind === viewKind),
  );
}

/** IDs dos atalhos servidos por um handler global de App.tsx. */
export const GLOBAL_HANDLER_SHORTCUT_IDS: readonly string[] = Object.freeze([
  'settings',
  'operator-profile',
  'task-board',
  'command-palette',
  'cheatsheet',
  'mission-new',
  'focus-pane-n',
  'split-right',
  'split-down',
  'close-pane',
]);
