import { askConfirm } from '../state/confirm-store';
import { useToastStore } from '../state/toast-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { removeMissionPrompt } from './mission-list-action';
import { removeMissionVerified } from './remove-mission-verified';

const pendingRemovals = new Set<string>();

/**
 * F-741: "Remover" no card do Quadro — o mesmo caminho da rail: confirmação
 * de perigo (nunca o confirm nativo, DESIGN.md §5), remoção verificada no
 * main e o toast do resultado. Só a missão do projeto aberto; um segundo
 * clique enquanto a primeira remoção corre não abre outra confirmação.
 */
export async function confirmAndRemoveMission(input: {
  readonly missionId: string;
  readonly title: string;
}): Promise<boolean> {
  const workspacePath = useWorkspaceStore.getState().current?.path;
  if (!workspacePath || pendingRemovals.has(input.missionId)) return false;
  pendingRemovals.add(input.missionId);
  try {
    const confirmed = await askConfirm({
      ...removeMissionPrompt({ title: input.title }),
      danger: true,
    });
    if (!confirmed) return false;
    const removed = await removeMissionVerified(input.missionId, workspacePath);
    if (!removed) {
      useToastStore
        .getState()
        .push('error', 'Não deu pra remover a missão', 'Tente de novo.');
      return false;
    }
    useToastStore
      .getState()
      .push('info', 'Missão removida', `“${input.title}” e o histórico foram apagados.`);
    return true;
  } catch (error) {
    useToastStore.getState().push(
      'error',
      'Não deu pra remover a missão',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  } finally {
    pendingRemovals.delete(input.missionId);
  }
}
