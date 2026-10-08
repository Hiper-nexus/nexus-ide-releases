import { useOrchStore } from '../state/orch-store';
import { paneInputLane } from './pane-input-route';
import {
  getPaneSessionId,
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  submitPromptToPaneOperatorInput,
} from './terminal-host';

/**
 * Envia um prompt completo pela MESMA lane que o teclado já usa.
 *
 * `submitPromptToPane` escreve no PTY cru. O main recusa isso em agentes
 * orquestrados (pty-manager.writeSession) — kickoff/handoff/skill morrem em
 * silêncio e o caller ainda vê `true`. Pane de missão vai pela lane do
 * operador, com recibo.
 */
export function submitLivePanePrompt(
  pane: {
    readonly id: string;
    readonly kind?: string;
    readonly adapterId?: string;
    readonly missionId?: string | null;
    readonly role?: 'orchestrator' | 'worker';
  },
  text: string,
): Promise<boolean> {
  const sessionId = getPaneSessionId(pane.id);
  if (!sessionId) return Promise.resolve(false);
  const lane = paneInputLane(
    pane,
    useOrchStore.getState().paneMissions[pane.id],
  );
  if (lane === 'operator') {
    return submitPromptToPaneOperatorInput(pane.id, text, sessionId);
  }
  if (pane.adapterId === 'kimi') return submitPromptToPaneConfirmed(pane.id, text, sessionId);
  return Promise.resolve(submitPromptToPane(pane.id, text));
}
