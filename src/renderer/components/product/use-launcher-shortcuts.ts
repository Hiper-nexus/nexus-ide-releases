/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/web/src/keybindings.ts.
 * Nexus changes: Nexus window shortcut listener checks actual focused/target editable contexts, composition and modifiers; callbacks/action names and product behavior are local, no upstream resolver code copied.
 */
import { useEffect, useRef } from 'react';
import { launcherActionIdForKey } from '../../lib/action-names';

function elementIsEditable(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return (
    node.tagName === 'INPUT' ||
    node.tagName === 'TEXTAREA' ||
    node.tagName === 'SELECT' ||
    node.isContentEditable === true
  );
}

/** Campo focado ou alvo do evento: dígito escolhe opção, não abre superfície. */
export function launcherShortcutTargetIsEditable(event: KeyboardEvent): boolean {
  return (
    elementIsEditable(event.target) ||
    elementIsEditable(document.activeElement)
  );
}

export type LauncherShortcutId =
  | 'pane'
  | 'mission'
  | 'workspace'
  | 'shell'
  | 'tasks'
  | 'memory';

export type LauncherShortcutActions = Record<LauncherShortcutId, () => void>;

/**
 * Atalhos 1–6 enquanto a tela de início está montada. O foco costuma
 * começar no body, então o listener é da janela. Cmd/Ctrl/Alt seguem
 * atalhos do app; campo editável não dispara.
 */
export function useLauncherShortcuts(
  enabled: boolean,
  actions: LauncherShortcutActions,
): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const id = launcherActionIdForKey(event.key, {
        targetIsEditable: launcherShortcutTargetIsEditable(event),
      });
      if (!id) return;
      event.preventDefault();
      // Segurar a tecla repete keydown. Uma ativação por toque: o 4 não
      // abre um terminal a cada repeat, e o 3 não abre vários seletores.
      if (event.repeat) return;
      const run = actionsRef.current[id as LauncherShortcutId];
      if (!run) return;
      run();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
