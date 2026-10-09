import { useEffect, useRef } from 'react';
import { launcherActionIdForKey } from '../../lib/action-names';

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
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editable =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;
      const id = launcherActionIdForKey(event.key, {
        targetIsEditable: editable,
      });
      if (!id) return;
      const run = actionsRef.current[id as LauncherShortcutId];
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
