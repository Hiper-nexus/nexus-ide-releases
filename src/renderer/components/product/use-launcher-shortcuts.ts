/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/web/src/keybindings.ts.
 * Nexus changes: Nexus window shortcuts check focused/target editable context,
 * composition/modifiers and repeat; action IDs/callbacks/scope behavior are local with no upstream
 * resolver code copied.
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

/** Presence/role alone is not modality: hidden history/attention panels may
 * remain mounted. Native modal state or aria-modal owns the current key scope.
 */
function hasActiveVisibleModal(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog')].some(element => {
    if (element instanceof HTMLDialogElement && !element.open) return false;
    let modal = element.getAttribute('aria-modal') === 'true';
    if (!modal && element instanceof HTMLDialogElement) {
      try { modal = element.matches(':modal'); } catch { modal = false; }
    }
    if (!modal) return false;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  });
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
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || hasActiveVisibleModal()) return;
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
