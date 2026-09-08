import { useRef, useState } from 'react';
import type { PaneModel } from '../../../shared/types';
import { listPanes } from '../../lib/split-tree';
import { runCleanupBatch } from '../../lib/cleanup-batch';
import { removeMissionVerified } from '../../orch/remove-mission-verified';
import { closeMissionRuntimeAndPanes } from '../../orch/close-mission-runtime';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { askConfirm } from '../../state/confirm-store';
import { useToastStore } from '../../state/toast-store';

async function closePaneSnapshot(panes: readonly PaneModel[], isCurrent: () => boolean) {
  const bindings = useOrchStore.getState().paneMissions;
  const ids = [...new Set(panes.map((pane) => pane.missionId ?? bindings[pane.id]).filter((id): id is string => Boolean(id)))];
  const failedMissions = new Set(ids);
  await runCleanupBatch(ids, isCurrent, async (id) => {
    const result = await closeMissionRuntimeAndPanes(id);
    if (result.ok) failedMissions.delete(id);
    return result.ok;
  });
  return runCleanupBatch(panes, isCurrent, async (pane) => {
    if (failedMissions.has(pane.missionId ?? bindings[pane.id] ?? '')) return false;
    if (listPanes(useLayoutStore.getState().root).some((item) => item.id === pane.id)) {
      useLayoutStore.getState().close(pane.id, 'mission-runtime-close');
    }
    return true;
  });
}

export function WorkspaceCleanup() {
  const workspace = useWorkspaceStore((state) => state.current);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  if (!workspace) return null;

  async function clean(kind: 'panes' | 'missions') {
    if (running.current || !workspace) return;
    running.current = true;
    setBusy(true);
    const path = workspace.path;
    const isCurrent = () => useWorkspaceStore.getState().current?.path === path;
    try {
      const panes = listPanes(useLayoutStore.getState().root).filter((pane) => !pane.isStructuralPlaceholder);
      const missions = kind === 'missions' ? await window.nexus.orch.listMissions() : [];
      if (!isCurrent()) return;
      const count = kind === 'panes' ? panes.length : missions.length;
      if (!count) {
        useToastStore.getState().push('info', 'Nada para limpar', 'Este projeto já está vazio.');
        return;
      }
      const confirmed = await askConfirm({
        title: kind === 'panes' ? `Fechar ${count} panes?` : `Apagar ${count} missões?`,
        body: kind === 'panes'
          ? `Projeto ${workspace.name}: os terminais e agentes serão encerrados. O histórico das missões será preservado.`
          : `Projeto ${workspace.name}: as missões serão encerradas e seu histórico apagado. Esta exclusão não pode ser desfeita. Os arquivos do projeto serão preservados.`,
        confirmLabel: kind === 'panes' ? 'Fechar todos os panes' : 'Apagar todas as missões',
        danger: true,
      });
      if (!confirmed || !isCurrent()) return;
      const result = kind === 'missions'
        ? await runCleanupBatch(missions, isCurrent, async (mission) => removeMissionVerified(mission.id, path))
        : await closePaneSnapshot(panes, isCurrent);
      useToastStore.getState().push(
        result.failed || result.interrupted ? 'error' : 'info',
        result.failed || result.interrupted ? 'Limpeza parcial' : 'Limpeza concluída',
        `${result.completed} ${kind === 'panes' ? 'panes fechados' : 'missões apagadas'}.${result.failed ? ` ${result.failed} falharam; tente novamente.` : ''}${result.interrupted ? ' Interrompida porque o projeto mudou.' : ''}`,
      );
    } catch (error) {
      console.error('[workspace-cleanup]', error);
      useToastStore.getState().push('error', 'Não foi possível limpar', 'Tente novamente. Nenhum arquivo do projeto foi apagado.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="workspace-cleanup">
      <span className="workspace-cleanup__title">Limpar projeto</span>
      <button type="button" disabled={busy} onClick={() => void clean('panes')}>Fechar todos os panes</button>
      <button type="button" disabled={busy} onClick={() => void clean('missions')}>Apagar todas as missões</button>
      {busy && <span role="status">Aguarde…</span>}
    </div>
  );
}
