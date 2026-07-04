import { create } from 'zustand';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { listPanes } from '../lib/split-tree';

/**
 * Confirmation before leaving a workspace. Closing kills every pane/session in
 * this workspace and returns to the launcher — so we warn explicitly that the
 * running terminals will be terminated — the
 * "Fechar workspace?" guard.
 */

interface CloseWorkspaceStore {
  open: boolean;
  ask(): void;
  cancel(): void;
}

export const useCloseWorkspaceStore = create<CloseWorkspaceStore>((set) => ({
  open: false,
  ask: () => set({ open: true }),
  cancel: () => set({ open: false }),
}));

export function CloseWorkspaceDialog() {
  const open = useCloseWorkspaceStore((s) => s.open);
  const cancel = useCloseWorkspaceStore((s) => s.cancel);
  const workspace = useWorkspaceStore((s) => s.current);
  const closeWorkspace = useWorkspaceStore((s) => s.close);
  const paneCount = useLayoutStore((s) => listPanes(s.root).length);

  if (!open || !workspace) return null;

  async function confirm() {
    // Layout is persisted per workspace, so the arrangement is restored next
    // time — but the LIVE sessions are killed. detachWorkspaceLayout (fired by
    // the App effect when current becomes null) flushes + stops persisting;
    // the terminal reconcile disposes every host and kills its PTY.
    await closeWorkspace();
    cancel();
  }

  return (
    <div className="confirm" role="alertdialog" aria-label="Fechar workspace">
      <div className="confirm__overlay" onClick={cancel} />
      <div className="confirm__panel">
        <h3 className="confirm__title">Fechar “{workspace.name}”?</h3>
        <p className="confirm__body">
          Isso encerra {paneCount} pane{paneCount === 1 ? '' : 's'} e finaliza
          todas as sessões/terminais em execução deste workspace. O layout é
          salvo e volta ao reabrir, mas o que está rodando agora será perdido.
        </p>
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={cancel}>
            Cancelar
          </button>
          <button
            className="confirm__btn confirm__btn--danger"
            onClick={() => void confirm()}
          >
            Fechar e finalizar tudo
          </button>
        </div>
      </div>
    </div>
  );
}
