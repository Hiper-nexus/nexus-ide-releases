import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { MissionEngineCommand, MissionSnapshot } from '../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../shared/types';
import { getRendererWorkspaceScope } from './persistence/renderer-workspace-scope';
import { sameProjectScope } from './orch/project-scoped-broadcast';
export interface PrivateQuestionCommandObservation {
  missionId: string; questionId: string; optionId?: string; kind: 'retry-kickoff' | 'answer-question'; refused: boolean; remainingQuestionId?: string; errorCode?: string;
}
let observer: { wc: WebContents; frame: Electron.WebFrameMain; scope: ProjectExecutionScope; nonce: string;
  snapshot(id: string): Promise<MissionSnapshot>; record(value: PrivateQuestionCommandObservation): void; failed(): void } | null = null;
/** Registered only by the private packaged acceptance controller in Main. */
export function armPrivateMissionCommandProbe(input: NonNullable<typeof observer>): () => void {
  if (observer) throw new Error('private command observer already armed'); observer = input;
  return () => { if (observer === input) observer = null; };
}
export async function observePrivateMissionCommand(event: IpcMainInvokeEvent, scope: ProjectExecutionScope, command: MissionEngineCommand,
  run: () => Promise<MissionSnapshot>): Promise<MissionSnapshot> {
  const owned = observer;
  const current = (): boolean => !!owned && observer === owned && event.sender === owned.wc && event.senderFrame === owned.frame &&
    owned.wc.mainFrame === owned.frame && sameProjectScope(scope, owned.scope) && !!getRendererWorkspaceScope(owned.wc) &&
    sameProjectScope(getRendererWorkspaceScope(owned.wc)!, owned.scope);
  if (!current() || !owned || !['retry-kickoff', 'answer-question'].includes(command.kind)) return run();
  const failed = (): void => { try { owned.failed(); } catch { /* A passive observer cannot change the canonical outcome. */ } };
  let questionId: string | undefined;
  try { questionId = (await owned.snapshot(command.missionId)).question?.id;
    if (command.kind === 'answer-question' && command.questionId !== questionId) { failed(); questionId = command.questionId; }
  } catch { failed(); }
  if (!current()) { failed(); throw new Error('private_command_authority_revoked'); }
  // The canonical command is still the sole producer of effects and errors.
  try {
    const result = await run();
    try { if (!current() || !questionId) failed(); else owned.record({ missionId: command.missionId, questionId,
      kind: command.kind as PrivateQuestionCommandObservation['kind'], ...(command.kind === 'answer-question' ? { optionId: command.optionId } : {}),
      refused: false, remainingQuestionId: result.question?.id }); } catch { failed(); }
    return result;
  } catch (error) {
    try { if (!current()) throw new Error('private observer revoked'); const after = await owned.snapshot(command.missionId);
      if (!current() || !questionId) failed(); else owned.record({ missionId: command.missionId, questionId,
        kind: command.kind as PrivateQuestionCommandObservation['kind'], refused: true, remainingQuestionId: after.question?.id,
        errorCode: error instanceof Error && /^[a-z0-9_:-]{1,96}$/iu.test(error.message) ? error.message : 'canonical-command-refused' });
    } catch { failed(); }
    throw error;
  }
}
